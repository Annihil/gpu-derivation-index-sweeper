# Third-party notices

## Vendored CUDA code

`vendor/blind-derivation/{derive.cu,secp256k1.cuh,hash.cuh}` are copied unmodified from:

- Project: https://github.com/stars-labs/blind-derivation
- Commit: `573455e70f0b7c1720395146a68135b6333b0cbf`
- Original location: `kernels/`
- Copyright: 2026 blind-derivation contributors
- License: MIT OR Apache-2.0

The complete upstream license texts are retained in `vendor/blind-derivation/LICENSE-MIT` and `LICENSE-APACHE`. This project adds the CUDA host program, exact membership lookup, configuration, import, checkpointing, and CPU verification around these kernels.

## Node dependencies

Dependencies are installed separately by `npm ci`. Their own notices and licenses remain in their packages:

- [bip32](https://github.com/bitcoinjs/bip32)
- [bitcoinjs-lib](https://github.com/bitcoinjs/bitcoinjs-lib)
- [tiny-secp256k1](https://github.com/bitcoinjs/tiny-secp256k1)
- [bs58check](https://github.com/bitcoinjs/bs58check)

No blockchain dataset is redistributed. Obtain a dataset from its provider under that provider's terms.
