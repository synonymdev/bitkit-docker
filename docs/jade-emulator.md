# Jade Emulator

The `jade-emulator` Compose profile runs Blockstream Jade firmware under QEMU as a
deterministic test device for Bitkit's Jade flows.

```bash
./scripts/jade-emulator start     # build if needed, start, wait for setup, print the device state
./scripts/jade-emulator status    # version info; fails while an app holds the connection
./scripts/jade-emulator logs
./scripts/jade-emulator stop
```

## How it is built

`scripts/jade-emulator.Dockerfile` builds the official 1.0.41 release in Blockstream's
pinned `jade_builder` image with `switch_to.sh qemu --dev --ci --psram`, then runs the flash
image on Espressif's `qemu-xtensa` for the host architecture. The builder is amd64 only, and
its QEMU never gets past the bootloader under Rosetta on Apple Silicon, so only the build
stage is emulated. The first build takes a few minutes; later starts reuse the image.

`--ci` makes the firmware enter PIN `012345` and confirm every on-device prompt (address
verification, signing) by itself. The upstream `--webdisplay` option turns that off, so this
image has no device screen.

## Device state

Each start copies the pristine flash (`JADE_WIPE=false` keeps the last one) and, on an
uninitialised device, loads `JADE_MNEMONIC`, sets the PIN for `JADE_NETWORK` through
Blockstream's pinserver (`https://j8d.io`), then reboots. Bitkit then finds the device locked,
unlocks it through the same pinserver and reads its keys, as with a real Jade.
`JADE_MNEMONIC=` (empty) leaves the device uninitialised.

The firmware serves one client at a time on port 30121, so the healthcheck only checks that
setup finished and QEMU runs, and `status` waits while an app is connected.

## What still needs a physical Jade

- Bluetooth and USB transports: the emulator is serial over TCP.
- Entering the PIN by hand, a wrong PIN, and the Jade's own screens: the CI firmware enters
  the right PIN and confirms every prompt.
- A firmware version below the app's minimum.
