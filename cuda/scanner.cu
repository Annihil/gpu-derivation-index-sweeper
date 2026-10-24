// Recovery host/membership code. Derivation kernels are included, unmodified,
// from stars-labs/blind-derivation (MIT OR Apache-2.0).
// See vendor/blind-derivation/LICENSE-MIT and LICENSE-APACHE.
#include <cuda_runtime.h>
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include "../vendor/blind-derivation/derive.cu"

#define CUDA(call) do { cudaError_t ltc_cuda_error = (call); if (ltc_cuda_error != cudaSuccess) throw std::runtime_error(std::string(#call) + ": " + cudaGetErrorString(ltc_cuda_error)); } while (0)

struct Entry { uint32_t key[5]; uint32_t occupied; uint64_t balance; };
static_assert(sizeof(Entry) == 32, "Unexpected table layout");

__host__ __device__ uint32_t hash_bucket(const uint32_t* key, uint32_t mask) {
    uint32_t h = 2166136261u;
    for (int j = 0; j < 5; ++j) h = (h ^ key[j]) * 16777619u;
    return (h ^ (h >> 16)) & mask;
}

__global__ void match_hashes(const uint8_t* hashes, const uint8_t* status,
    uint32_t start, uint32_t count, const Entry* table, uint32_t mask,
    uint32_t* counters, uint32_t* hits, uint32_t* invalid, bool wrapped) {
    uint32_t i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    if (status[i]) { invalid[atomicAdd(counters + 1, 1u)] = start + i; return; }
    const uint8_t* p = hashes + (size_t)i * 20;
    uint8_t wrapped_hash[20];
    if (wrapped) {
        uint8_t script[22], digest[32]; script[0]=0; script[1]=20;
        for(int j=0;j<20;j++)script[j+2]=p[j];
        sha256_oneblock(script,22,digest);ripemd160_oneblock(digest,32,wrapped_hash);
        p=wrapped_hash;
    }
    uint32_t key[5];
    for (int j = 0; j < 5; ++j) key[j] = (uint32_t)p[4*j] | (uint32_t)p[4*j+1] << 8 | (uint32_t)p[4*j+2] << 16 | (uint32_t)p[4*j+3] << 24;
    uint32_t slot = hash_bucket(key, mask);
    for (uint32_t tries = 0; tries <= mask; ++tries, slot = (slot + 1) & mask) {
        const Entry* e = table + slot;
        if (!e->occupied) return;
        bool equal = true;
        for (int j = 0; j < 5; ++j) equal = equal && key[j] == e->key[j];
        if (equal) {
            uint32_t hit = atomicAdd(counters, 1u);
            hits[2*hit] = start + i;
            hits[2*hit+1] = slot;
            return;
        }
    }
}

static std::vector<uint8_t> read_file(const std::string& file) {
    std::ifstream in(file, std::ios::binary | std::ios::ate);
    if (!in) throw std::runtime_error("Cannot open " + file);
    auto size = in.tellg();
    if (size < 0) throw std::runtime_error("Cannot measure " + file);
    std::vector<uint8_t> out((size_t)size);
    in.seekg(0);
    if (!out.empty() && !in.read((char*)out.data(), out.size())) throw std::runtime_error("Cannot read " + file);
    return out;
}

static std::string hex(const uint8_t* data, size_t len) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for (size_t i = 0; i < len; ++i) out << std::setw(2) << (unsigned)data[i];
    return out.str();
}

template<class T> static T load(const uint8_t* p) { T v; std::memcpy(&v, p, sizeof(T)); return v; }

struct Engine {
    std::vector<void*> allocations;
    uint8_t *pub, *chain, *x, *y, *gtable, *out_pub, *out_hash, *out_status;
    uint32_t capacity;
    template<class T> T* alloc(size_t n) {
        T* p;
        CUDA(cudaMalloc((void**)&p, n * sizeof(T)));
        allocations.push_back(p);
        return p;
    }
    uint8_t* upload(const uint8_t* p, size_t n) {
        auto d = alloc<uint8_t>(n);
        CUDA(cudaMemcpy(d, p, n, cudaMemcpyHostToDevice));
        return d;
    }
    Engine(const std::string& branch_file, const std::string& table_file, uint32_t batch) : capacity(batch) {
        CUDA(cudaSetDevice(0));
        cudaDeviceProp prop{};
        CUDA(cudaGetDeviceProperties(&prop, 0));
        std::cout << "{\"event\":\"gpu-device\",\"name\":\"" << prop.name << "\",\"batch\":" << batch << "}" << std::endl;
        auto branch = read_file(branch_file);
        auto table = read_file(table_file);
        if (branch.size() != 129 || table.size() != 32*255*64) throw std::runtime_error("Invalid branch/generator table length");
        pub = upload(branch.data(), 33);
        chain = upload(branch.data()+33, 32);
        x = upload(branch.data()+65, 32);
        y = upload(branch.data()+97, 32);
        gtable = upload(table.data(), table.size());
        out_pub = alloc<uint8_t>((size_t)batch * 33);
        out_hash = alloc<uint8_t>((size_t)batch * 20);
        out_status = alloc<uint8_t>(batch);
    }
    void derive(uint32_t start, uint32_t count) {
        if (count > capacity || (uint64_t)start + count > 0x80000000ULL) throw std::runtime_error("Invalid GPU index range");
        derive_child_kernel<<<(count+63)/64, 64>>>(pub, chain, x, y, gtable, start, count, out_pub, out_hash, out_status);
        CUDA(cudaGetLastError());
        CUDA(cudaDeviceSynchronize());
    }
    ~Engine() { for (auto p : allocations) cudaFree(p); }
};

static void dump(Engine& e, uint32_t start, uint32_t count, const std::string& file) {
    std::ofstream out(file, std::ios::binary | std::ios::trunc);
    if (!out) throw std::runtime_error("Cannot create dump output");
    auto began = std::chrono::steady_clock::now();
    for (uint64_t offset = 0; offset < count; offset += e.capacity) {
        auto n = (uint32_t)std::min<uint64_t>(e.capacity, count - offset);
        e.derive(start + (uint32_t)offset, n);
        std::vector<uint8_t> pub((size_t)n*33), h((size_t)n*20), status(n), records((size_t)n*54);
        CUDA(cudaMemcpy(pub.data(), e.out_pub, pub.size(), cudaMemcpyDeviceToHost));
        CUDA(cudaMemcpy(h.data(), e.out_hash, h.size(), cudaMemcpyDeviceToHost));
        CUDA(cudaMemcpy(status.data(), e.out_status, status.size(), cudaMemcpyDeviceToHost));
        for (uint32_t i=0; i<n; ++i) {
            records[(size_t)i*54] = status[i];
            std::memcpy(records.data()+(size_t)i*54+1, pub.data()+(size_t)i*33, 33);
            std::memcpy(records.data()+(size_t)i*54+34, h.data()+(size_t)i*20, 20);
        }
        out.write((char*)records.data(), records.size());
        if (!out) throw std::runtime_error("Dump output write failed");
    }
    double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now()-began).count();
    std::cout << "{\"event\":\"gpu-dump-complete\",\"count\":" << count << ",\"seconds\":" << seconds << ",\"addressesPerSecond\":" << count/seconds << "}" << std::endl;
}

static void scan(Engine& e, const std::string& dataset, uint32_t start, uint32_t end) {
    auto raw = read_file(dataset);
    if (raw.size() < 128 || std::memcmp(raw.data(), "IDXSET02", 8) || load<uint32_t>(raw.data()+8) != 2 || load<uint32_t>(raw.data()+12) != 28) throw std::runtime_error("Invalid dataset header");
    uint64_t count = load<uint64_t>(raw.data()+16);
    if (count > 100000000 || raw.size() != 128 + count*28) throw std::runtime_error("Invalid dataset count/length");
    const bool wrapped = std::memcmp(raw.data()+80,"p2sh-p2wpkh",11)==0;
    uint32_t capacity=16;
    while (capacity < count/0.65) capacity*=2;
    std::vector<Entry> table(capacity);
    for (uint64_t i=0; i<count; ++i) {
        auto p = raw.data()+128+i*28;
        Entry entry{};
        std::memcpy(entry.key, p, 20);
        entry.occupied=1;
        entry.balance=load<uint64_t>(p+20);
        uint32_t slot=hash_bucket(entry.key, capacity-1);
        while (table[slot].occupied) {
            if (!std::memcmp(table[slot].key, entry.key, 20)) { if(table[slot].balance!=entry.balance) throw std::runtime_error("Conflicting duplicate balances"); break; }
            slot=(slot+1)&(capacity-1);
        }
        table[slot]=entry;
    }
    auto device_table=e.alloc<Entry>(capacity);
    CUDA(cudaMemcpy(device_table, table.data(), (size_t)capacity*sizeof(Entry), cudaMemcpyHostToDevice));
    auto counters=e.alloc<uint32_t>(2);
    auto hits=e.alloc<uint32_t>((size_t)e.capacity*2);
    auto invalid=e.alloc<uint32_t>(e.capacity);
    auto began=std::chrono::steady_clock::now();
    for (uint64_t next=start; next<=(uint64_t)end; ) {
        uint32_t n=(uint32_t)std::min<uint64_t>(e.capacity, (uint64_t)end+1-next);
        auto tick=std::chrono::steady_clock::now();
        e.derive((uint32_t)next,n);
        CUDA(cudaMemset(counters,0,8));
        match_hashes<<<(n+255)/256,256>>>(e.out_hash,e.out_status,(uint32_t)next,n,device_table,capacity-1,counters,hits,invalid,wrapped);
        CUDA(cudaGetLastError());
        uint32_t host_count[2];
        CUDA(cudaMemcpy(host_count,counters,8,cudaMemcpyDeviceToHost));
        std::vector<uint32_t> host_hits((size_t)host_count[0]*2),host_invalid(host_count[1]);
        if (!host_hits.empty()) CUDA(cudaMemcpy(host_hits.data(),hits,host_hits.size()*4,cudaMemcpyDeviceToHost));
        if (!host_invalid.empty()) CUDA(cudaMemcpy(host_invalid.data(),invalid,host_invalid.size()*4,cudaMemcpyDeviceToHost));
        for (uint32_t j=0;j<host_count[0];++j) {
            uint32_t index=host_hits[j*2],slot=host_hits[j*2+1];
            std::cout << "{\"event\":\"gpu-hit\",\"index\":" << index << ",\"hash\":\"" << hex((const uint8_t*)table[slot].key,20) << "\",\"balanceBaseUnits\":\"" << table[slot].balance << "\"}" << std::endl;
        }
        for (auto index:host_invalid) std::cout << "{\"event\":\"gpu-invalid\",\"index\":" << index << "}" << std::endl;
        // Samples from every batch are independently rederived by the Node host.
        std::cout << "{\"event\":\"gpu-batch\",\"nextIndex\":" << next+n << ",\"samples\":[";
        uint32_t random=(uint32_t)next ^ 0xa0761d65u;
        for (unsigned j=0;j<16;++j) {
            random=random*1664525u+1013904223u;
            uint32_t relative=j==0?0:j==1?n-1:random%n;
            uint8_t sample[20],status;
            CUDA(cudaMemcpy(sample,e.out_hash+(size_t)relative*20,20,cudaMemcpyDeviceToHost));
            CUDA(cudaMemcpy(&status,e.out_status+relative,1,cudaMemcpyDeviceToHost));
            if(j)std::cout << ',';
            std::cout << "{\"index\":" << next+relative << ",\"status\":" << (unsigned)status << ",\"hash\":\"" << hex(sample,20) << "\"}";
        }
        double batch_seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-tick).count();
        next+=n;
        double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-began).count();
        std::cout << "],\"batchSeconds\":" << batch_seconds << ",\"addressesPerSecond\":" << (next-start)/seconds << "}" << std::endl;
    }
    std::cout << "{\"event\":\"gpu-complete\"}" << std::endl;
}

int main(int argc,char** argv) {
    try {
        if(argc!=8) throw std::runtime_error("Usage: index_scan_gpu dump BRANCH GTABLE START COUNT BATCH OUTPUT | scan BRANCH GTABLE DATA START END BATCH");
        std::string command=argv[1];
        unsigned long batch=std::stoul(argv[6+(command=="scan")]);
        if(batch<1 || batch>1048576)throw std::runtime_error("Invalid batch size");
        Engine engine(argv[2],argv[3],(uint32_t)batch);
        if(command=="dump") {
            uint64_t start=std::stoull(argv[4]),count=std::stoull(argv[5]);
            if(!count || start+count>0x80000000ULL)throw std::runtime_error("Invalid dump range");
            dump(engine,(uint32_t)start,(uint32_t)count,argv[7]);
        } else if(command=="scan") {
            uint64_t start=std::stoull(argv[5]),end=std::stoull(argv[6]);
            if(start>end || end>0x7fffffffULL)throw std::runtime_error("Invalid scan range");
            scan(engine,argv[4],(uint32_t)start,(uint32_t)end);
        } else throw std::runtime_error("Unknown command");
        return 0;
    } catch(const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
