# Jade Emulator

The `jade-emulator` Compose profile runs Blockstream Jade firmware under QEMU as a
deterministic test device for Bitkit's Jade flows.

```bash
./scripts/jade-emulator start     # build if needed, start, wait for setup, print the device state
./scripts/jade-emulator status    # version info; fails while an app holds the connection
./scripts/jade-emulator press front           # press device buttons (interactive mode)
./scripts/jade-emulator pin 012345            # enter a PIN on the device (interactive mode)
./scripts/jade-emulator passphrase test       # enter a BIP39 passphrase on the device (interactive mode)
./scripts/jade-emulator screen shot.png       # save the device screen (interactive mode)
./scripts/jade-emulator logs
./scripts/jade-emulator stop
```

## Modes

`JADE_MODE` picks the firmware the container runs:

| Mode | Firmware | Behaviour |
|---|---|---|
| `auto` (default) | 1.0.41, `--dev --ci --psram` | Enters the PIN and confirms every prompt (address check, signing) by itself. |
| `interactive` | 1.0.41, `--dev --psram --webdisplay` | Shows its real screens and waits for buttons: drive it with `press`, `pin` and `screen`. |
| `old` | 1.0.33, CI build | Auto-confirming firmware older than taproot address support (1.0.34). |

`press` takes `left`, `right`, `click` (wheel press) and `front` (the select button) and
presses them one at a time; a press that leaves the screen unchanged (a busy host can drop one)
is pressed again, up to three times. The interactive PIN pad starts every digit at 0, so `pin` steps right to
each digit and selects it, waiting on the screen for each digit's box first, so it can run as soon
as the app asks for the PIN. A digit whose box shows no change after its presses (a pad that just
appeared can drop them) is pressed again. A wrong `pin` shows the device's own "Incorrect PIN!" screen; the
next `pin` presses its Continue first and finds the retry pad, which sits lower under its
"attempts remaining" line.
`passphrase` types lowercase letters and spaces on the device's Manual passphrase keyboard, reading
the highlighted key from the screen before each step, then confirms. `screen` saves the 240×135
display as a PNG. A `pin` or `passphrase` that times out saves the screen it saw to
`/tmp/jade-timeout.png` in the container.

On the interactive device, `front` selects the highlighted button:

- Signing shows one Output screen per output with the next arrow selected (`press front`),
  then Send Transaction with the fee, where X is selected: `press right front` signs and
  `press front` declines.
- Verify on Device shows Verify Address with the back arrow selected: `press right front`
  confirms and `press front` declines.
- On the unlocked dashboard, `press front right front` chooses Session, then Log Out.

## How it is built

`scripts/jade-emulator.Dockerfile` builds the official 1.0.41 release twice (`auto` and
`interactive`) in Blockstream's pinned `jade_builder` image, and 1.0.33 in the pinned `verde`
image of its time, then runs the flash images on Espressif's `qemu-xtensa` for the host
architecture. The builders are amd64 only, and their QEMU never gets past the bootloader
under Rosetta on Apple Silicon, so only the build stages are emulated. The first build takes
several minutes; later starts reuse the image.

Two patches apply to the firmware sources:

- Debug builds skip the network restriction a PIN unlock sets. The patch keeps it, so a
  device set up for mainnet refuses a testnet request, as a retail Jade does. Patched builds
  report their version as `1.0.41-dirty`.
- The interactive PIN pad starts each digit at 0 instead of a random digit, so `pin` only
  needs to find the active box, not read digits.

## Device state

Each start copies the pristine flash (`JADE_WIPE=false` keeps the last one) and, on an
uninitialised device, loads `JADE_MNEMONIC`, sets the PIN for `JADE_NETWORK` through
Blockstream's pinserver (`https://j8d.io`), then reboots. Bitkit then finds the device locked,
unlocks it through the same pinserver and reads its keys, as with a real Jade.

| Variable | Default | Effect |
|---|---|---|
| `JADE_MODE` | `auto` | Firmware, see Modes. |
| `JADE_MNEMONIC` | test seed | Empty leaves the device uninitialised. |
| `JADE_PIN` | `012345` | PIN set at setup; `interactive` mode only, the other modes enter it themselves. |
| `JADE_NETWORK` | `testnet` | `mainnet` restricts the device to mainnet (`auto` and `interactive`; `old` runs unpatched 1.0.33, which keeps no restriction). |
| `JADE_PINSERVER_URL` | unset | Points the device at another pinserver after setup. |
| `JADE_PASSPHRASE` | unset | `always` makes an interactive device ask for a BIP39 passphrase after every PIN, set through its own menu since the firmware has no RPC for it. |

The firmware serves one client at a time on port 30121, so the healthcheck only checks that
setup finished and QEMU runs, and `status` waits while an app is connected. Port 30122
carries the interactive display and buttons.

## Error recipes

| App error | Recipe |
|---|---|
| Device not set up | `JADE_MNEMONIC= ./scripts/jade-emulator start` |
| Wrong PIN | `JADE_MODE=interactive`, connect, then `./scripts/jade-emulator pin 999999` |
| Network mismatch | `JADE_NETWORK=mainnet ./scripts/jade-emulator start` with a regtest app |
| Transaction too large | Point the app's Electrum Server at this repo's Electrum (`10.0.2.2:60001` TCP from an Android emulator, `127.0.0.1:60001` from a simulator), split the Jade's funds into many inputs (`for i in $(seq 200); do ./bitcoin-cli sendtoaddress <jade address> 0.0002; [ $((i % 20)) = 0 ] && ./bitcoin-cli -generate 1; done`, mining every 20 sends to stay under the mempool's chain limit), then send the Jade's whole balance: the PSBT passes the client's 16 KiB limit |
| Different wallet | Pair, then restart with another seed (`JADE_MNEMONIC="abandon ... about" ./scripts/jade-emulator start`) and verify an address |
| Passphrase wallet | `JADE_MODE=interactive JADE_PASSPHRASE=always`, connect, then `pin 012345` and `passphrase test`: the app pairs the passphrase wallet as another wallet of the same Jade |
| Device busy (locked) | `JADE_MODE=interactive`, pair, then log out on the device (`press front right front`: Session → Log Out) and verify an address or sign. Android shows the busy message; iOS asks for the PIN on the device again and retries |

## What still needs a physical Jade

- Bluetooth and USB transports: the emulator is serial over TCP.
- The camera (QR mode).
