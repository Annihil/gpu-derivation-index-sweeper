# GPU derivation index sweeper

Recover missing address indices beneath a known BIP32 extended public key. Scan a whole non-hardened index range, or a smaller range, against a local address dataset using CPU workers or an NVIDIA CUDA GPU.

For example, if you know the account public key and used `account/1/index`, but lost `index`, this tool can search `1/*` and report matching indices and addresses. It scans public addresses; spending remains a separate operation requiring your original wallet keys. It does not create or broadcast transactions.

## Supported inputs

- Bitcoin and Litecoin mainnet and testnet.
- Legacy P2PKH, native SegWit P2WPKH, and wrapped SegWit P2SH-P2WPKH.
- A public extended key: xpub/tpub, single-signature ypub/zpub/upub/vpub, or Litecoin Ltub/Mtub. The selected address type is explicit; a key's prefix does not override it.
- Any relative, non-hardened branch: `1/*`, `0/7/*`, or `*` when the supplied key is already at the address parent.
- Inclusive index ranges from `0` through `2147483647`.
- Gzipped or plain TSV containing `address` and `balance` columns, or one known address per line.

Hardened children require private derivation and cannot be generated from an xpub. Taproot, arbitrary scripts, seed recovery, and searching unknown parent paths are outside this version's scope. An xpub does not identify its full path from the seed.

## Install and try a synthetic wallet

Install Node.js 22 or newer, then run:

```sh
npm ci --ignore-scripts
npm test
npm run demo
node bin/sweep.mjs prepare --network litecoin --address-type p2pkh --input runs/demo/addresses.tsv --output runs/demo/targets.bin
node bin/sweep.mjs scan --config runs/demo/wallet.local.json --data runs/demo/targets.bin --engine cpu --start 0 --end 100 --out-dir runs/demo/cpu
```

The demo has synthetic matches at indices **7, 42, and 99**. Its deterministic test keys are public fixtures and must never receive real funds. Generated demo files live in the ignored `runs/` directory.

## Configure your public key

Copy `examples/wallet.example.json` to `wallet.local.json` in the repository root. Save your public extended key, without quotes, in `wallet.xpub` alongside it:

```json
{
  "xpubFile": "wallet.xpub",
  "branch": "1/*",
  "network": "litecoin",
  "addressType": "p2pkh"
}
```

Paths inside a config file are relative to that file. Command-line paths are relative to the current directory. Command-line options override config fields. You can also supply `--xpub-file wallet.xpub` and `--branch "1/*"` directly. `--xpub` accepts a literal public key, but a local file avoids placing it in shell history.

The xpub must be at or above the specified branch. For an account xpub, `1/*` searches its `/1/index` children. For an xpub already at `/1`, use `*`. No account prefix is guessed or added.

## Prepare an address lookup

Create `data/` and obtain an address dataset for the selected network. [Blockchair publishes address-balance datasets](https://blockchair.com/dumps); access and download limits are determined by the provider. Other exports work if they use the same format:

```text
address<TAB>balance
```

Balances must be nonnegative integers in the network's smallest unit: satoshis for Bitcoin or litoshis for Litecoin. Decimal coin amounts are rejected. Zero-balance rows and addresses outside the selected network/type are skipped.

```sh
node bin/sweep.mjs prepare --network litecoin --address-type p2pkh --input data/addresses.tsv.gz --output data/targets.bin
```

For known addresses where you only need to recover indices, use a plain or gzipped file with one address per line:

```sh
node bin/sweep.mjs prepare --network bitcoin --address-type p2wpkh --format addresses --input data/known-addresses.txt --output data/targets.bin
```

Known-address matches report `balanceBaseUnits: null`, meaning the input did not specify a balance. Identical duplicate rows are accepted; conflicting duplicate balances are rejected when building the lookup table.

Preparation validates gzip checksums and writes the prepared dataset only after successful import. The binary records the network, address type, and source checksum. Raw Litecoin Core/Bitcoin Core `dumptxoutset` files are not TSV and need separate conversion.

For wrapped SegWit, the importer accepts P2SH address rows as candidates; a scan matches them only if its derived wrapped-SegWit script hash agrees.

## Scan and resume

Start with a small range to confirm your configuration:

```sh
node bin/sweep.mjs scan --config wallet.local.json --data data/targets.bin --engine cpu --workers 16 --start 0 --end 999 --out-dir runs/small
```

To scan the entire non-hardened final index range:

```sh
node bin/sweep.mjs scan --config wallet.local.json --data data/targets.bin --engine gpu --start 0 --end 2147483647 --out-dir runs/full
```

`--start` and `--end` are inclusive. Defaults are `0` and `2147483647`; small examples specify their bounds intentionally. The CPU default is at most 16 workers. GPU batches default to 16,384 indices and can be changed with `--batch`.

Progress and results are written to the chosen output directory:

- `status.json`: phase, checked count, rate, and estimated time remaining.
- `matches.json`: matching indices, relative paths, addresses, and input balances.
- `cpu-state.json` or `gpu-state.json`: resumable checkpoint.
- `.cache/`: temporary public branch data and generator precomputation used by CUDA.

```sh
node bin/sweep.mjs status --out-dir runs/full
```

Rerun the same command to resume. Checkpoints are saved periodically and whenever a match is found; a hard interruption may repeat recent work. Input, branch, network, address type, and range must match. CPU resumes also require the same worker count; GPU resumes require the same executable. Use a new output directory for a different job or rebuilt GPU executable. A run lock prevents two commands from writing the same directory.

## Build the optional CUDA engine

Requirements: an NVIDIA GPU, a compatible NVIDIA driver and CUDA toolkit, CMake 3.24+, and a C++ host compiler supported by your CUDA version. The CPU backend needs none of these.

On Windows, use **Developer PowerShell for Visual Studio** with the C++ tools installed. On Linux, use a shell with the CUDA toolkit and its supported host compiler on `PATH`:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
npm run test:gpu
```

On Windows, the `Ninja` generator can be selected with `-G Ninja` when Ninja is installed. CMake defaults to the current GPU's native architecture. For a specific target, configure with `-DCMAKE_CUDA_ARCHITECTURES=86`, `89`, or `120`, as appropriate. RTX 50-series cards require a toolkit that supports their architecture.

The executable is placed in `build/bin/`. Use `--gpu-binary PATH` for a different location. Each GPU scan validates a sample against the CPU library before scanning, verifies samples from every batch, and independently verifies every reported match.

`npm run test:gpu` exercises real kernels, including multiple address types, checkpoint resume, batch boundaries, and the largest non-hardened index. It requires a built executable and an NVIDIA GPU. Standard GitHub CI runs the CPU/CLI tests on Windows, Linux, and macOS with Node 22 and 24.

## How it works and performance

The fixed parent branch is derived once. For each final index, the scanner performs BIP32 public child derivation, computes the relevant address hash, and probes an exact lookup table. The CUDA backend performs both derivation and membership lookup on the GPU. It generates address strings only for matches.

This avoids a network request per candidate. Scanning is offline; reported balances reflect the input snapshot. A missing match can mean an incorrect public key/branch/type or an incomplete/outdated dataset. Confirm the current state of any matches separately.

In the recovery run that motivated this project, an earlier Litecoin P2PKH implementation checked about 2.147 billion indices against about 3.3 million target addresses in **5 minutes 39 seconds** on an RTX 5090, about **6.3 million indices/second**. CPU benchmarks on a Ryzen 9 9950X3D projected about **3.5 hours** using 32 workers. These are reference measurements, not guarantees for every dataset, script type, GPU, or release.

Lookup storage is approximately `32 × nextPowerOfTwo(targetCount / 0.65)` bytes, plus input data and working buffers. The reference lookup occupied 256 MiB. CUDA needs the lookup in GPU memory and the coordinator also holds a CPU copy for verification.

## Keeping your wallet data local

Public extended keys reveal related addresses even though they cannot spend funds. Keep your real keys in ignored `*.xpub`, `*.local.json`, or `secrets/` files, and datasets/results in `data/` or `runs/`. Review staged files before publishing a fork. This repository's committed examples and tests generate synthetic wallets; no original recovery keys, addresses, balances, logs, or datasets are included.

After staging intended changes, `npm run check:public` checks the Git index for literal extended keys and generated/local-data artifacts. It reports filenames without printing key contents. This checks the staged tree only.

## Credits and license

MIT license for this project's code. The CUDA derivation and cryptographic kernels are vendored unmodified from [stars-labs/blind-derivation](https://github.com/stars-labs/blind-derivation), pinned at commit `573455e70f0b7c1720395146a68135b6333b0cbf`, under its MIT OR Apache-2.0 licensing. Both upstream license texts and provenance are included in `vendor/blind-derivation/`.

The Node.js implementation uses `bip32`, `bitcoinjs-lib`, `tiny-secp256k1`, and `bs58check`. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
