# Trezor Emulator Checks

## Isolated automatic fixture

The `trezor-emulator` Compose profile provides a Linux-compatible service with
published ports, a reusable named image, project-scoped state and logs, and a
healthcheck. It uses the same pinned official User Env image as the manual
workflow, including its bundled SDL3 runtime. Startup launches the
controller and initializes Bridge plus the deterministic T2T1 device, with bounded
startup waits and process cleanup on exit. Firmware `2-main` and `node-bridge`
refer to binaries already frozen in the base image's digest.

```bash
docker compose --profile trezor-emulator up -d --build --wait trezor-emulator
docker compose --profile trezor-emulator ps trezor-emulator
docker compose --profile trezor-emulator logs --tail 80 trezor-emulator
curl -fsS -X POST http://127.0.0.1:21325/enumerate
docker compose --profile trezor-emulator exec -T trezor-emulator \
  /trezor-user-env/.venv/bin/python3 /opt/bitkit-trezor/trezor-fixture-check.py
```

Ports: Bridge legacy `21325`, Bridge current `21328`, controller `23901`, dashboard
`23902`, and noVNC `23680`. The controller is published on a different port from
the manual User Env's `9001`, which Bitkit's UI tests dial. Docker-backed simulator seats remap
these base ports and forward them to their seat's loopback address. Declare this
profile as an on-demand offer; run no global shared device instance.

Every start wipes only its own emulator and loads the public `all all ...` test
seed, no PIN (unless `TREZOR_PIN` is set), no passphrase and the `Bitkit Test Trezor`
label. `TREZOR_MODEL` and `TREZOR_FIRMWARE` pick another emulator, as for the
manual User Env. Its two named
volumes belong to the Compose project. Bridge enumeration must contain a device,
and controller status must report both emulator and Bridge running, before the
container is healthy. Confirmations remain controlled by the dashboard or
controller so the runner can observe and approve signing prompts.

`trezor-fixture-check.py` is a bounded, offline fixture diagnostic. It talks to
the device through Bridge, derives the expected public key independently from
the public test seed, obtains regtest addresses, signs a synthetic SegWit
transaction and verifies its signature independently. The debug link approves
its signing prompts and restores the normal interaction mode afterwards. Run
it before connecting an app; it neither runs an app journey nor broadcasts.

The fixture does not run its own Bitcoin stack. Use the existing regtest node and
Electrum server to fund the derived address and broadcast signed transactions.
Avoid starting the manual User Env alongside this profile on the same base ports.

## PIN entry

Set `TREZOR_PIN` when starting either the fixture or the manual User Env. Setup
loads the seed with that PIN and then locks the device, so the app finds it locked
as after power-on and must unlock it before reading keys:

```bash
TREZOR_PIN=1234 ./scripts/trezor-emulator start
TREZOR_PIN=1234 TREZOR_MODEL=T1B1 TREZOR_FIRMWARE=1-main ./scripts/trezor-emulator start
TREZOR_PIN=1234 docker compose --profile trezor-emulator up -d --build --wait trezor-emulator
```

Once the app asks for the PIN, enter it, right or wrong, with `pin`:

```bash
./scripts/trezor-emulator pin 1234    # right PIN
./scripts/trezor-emulator pin 9999    # wrong PIN
TREZOR_SERVICE=trezor-emulator TREZOR_PROFILE=trezor-emulator ./scripts/trezor-emulator pin 1234   # fixture
```

| Model | Where the PIN goes | What `pin` does |
|---|---|---|
| T2T1, T3T1 | The device's own PIN keyboard; the app waits | Types the PIN through the debug link, then prints `PIN accepted.` or `PIN rejected: the device asks for it again.` |
| T1B1 | The app's PIN matrix (Bitkit's PIN dialog) | Prints the keys to tap in the app's matrix (7 8 9 top row, 1 2 3 bottom row) for the device's current scrambled layout |

On T1B1 a wrong PIN fails the app's request with `PIN invalid`, and the next
request shows a new matrix, so run `pin` again for it. On T2T1 and T3T1 the device
asks again after a wrong PIN with a freshly shuffled keyboard. Every start wipes the
device, which resets the failed-attempt count. `pin` exits with an error when the
device is not asking for a PIN.

`get-address` and `status --json` fail while the device is locked; unlock it
first. `trezor-fixture-check.py` checks the default fixture, which has no PIN, so
it fails when `TREZOR_PIN` is set.

## Manual User Env

Bitkit app PRs that need Trezor hardware behavior can use the official Trezor User Env through this repo. The helper starts the User Env without its extra regtest stack, starts Trezor Bridge, wipes a deterministic T2T1 emulator, and configures it with a stable seed and label.

## Start the Emulator

```bash
./scripts/trezor-emulator start
```

On macOS, the Trezor User Env service is part of the default compose stack, so `docker compose up -d` starts it with the rest of the Bitkit services. The helper is still useful because it resets Bridge and the emulator into the deterministic review state.

Linux needs host networking for Trezor User Env, so its service stays behind the `trezor-linux` profile:

```bash
docker compose --profile trezor-linux up -d trezor-user-env-linux
```

The default emulator configuration is:

- model: `T2T1`
- firmware: `2-main`
- bridge: `node-bridge`
- mnemonic: `all all all all all all all all all all all all`
- pin: empty (`TREZOR_PIN`, see PIN entry)
- passphrase protection: off
- label: `Bitkit Test Trezor`

You can override these with environment variables, for example:

```bash
TREZOR_MODEL=T3T1 TREZOR_FIRMWARE=3-main ./scripts/trezor-emulator start
```

## App Setup

Use the same emulator stack for Bitkit Android and Bitkit iOS work. The commands below are app-specific launch notes; the emulator and Bridge setup stays the same.

### Bitkit Android

For a physical phone:

```bash
./scripts/trezor-emulator adb
TREZOR_BRIDGE=true TREZOR_BRIDGE_URL=http://127.0.0.1:21325 ./gradlew installDevDebug
```

For an Android emulator:

```bash
TREZOR_BRIDGE=true TREZOR_BRIDGE_URL=http://10.0.2.2:21325 ./gradlew installDevDebug
```

The Trezor dashboard is under `Settings -> Advanced -> Dev Settings -> Trezor`.

### Bitkit iOS

Run Bitkit from Xcode on the relevant Trezor branch, then open `Settings -> Advanced -> Trezor Hardware Wallet`.

The User Env dashboard and Bridge remain available at the same localhost endpoints:

- User Env dashboard: <http://localhost:23902>
- Trezor Bridge: <http://localhost:21325>

## Smoke Checklist

Use this checklist when reviewing any Bitkit app PR that needs the Trezor emulator:

- Scan shows the Bridge emulator device.
- Connect succeeds and device features are shown.
- Get address succeeds.
- Get public key succeeds.
- Sign and verify message succeed.
- Send or compose reaches the expected funded or no-funds state.
- Disconnect, reconnect, and forget-device cleanup behave correctly.

## Helpful Commands

```bash
./scripts/trezor-emulator status
./scripts/trezor-emulator pin 1234
./scripts/trezor-emulator logs
./scripts/trezor-emulator stop
```

Open the User Env dashboard at <http://localhost:23902>. Trezor Bridge listens at <http://localhost:21325>.

## Troubleshooting

### `RuntimeError('Emulator process died')`

The emulator needs the Xvfb virtual display. When the container is stopped
ungracefully, Xvfb can leave `/tmp/.X<n>-lock` and `/tmp/.X11-unix/X<n>` behind.
The container filesystem survives restarts, so Xvfb then refuses to start with
`Server is already active for display <n>`, the emulator fails with
`SDL_Init error` / `No available video device`, and the controller reports
`RuntimeError('Emulator process died')`.

`./scripts/trezor-emulator start` now removes these locks automatically when no
live Xvfb owns them. To clear them by hand:

```bash
docker compose exec trezor-user-env-mac sh -c 'rm -f /tmp/.X42-lock /tmp/.X11-unix/X42'
```

If a start attempt leaves the controller wedged (for example `emulator-setup`
hanging after a failed start), restart the service before retrying:

```bash
docker compose restart trezor-user-env-mac
./scripts/trezor-emulator start
```

## How It Works

`scripts/trezor-emulator` is the entrypoint. It starts this repo's Trezor User Env Compose service, then runs `scripts/trezor-controller.py` inside that container with `/trezor-user-env/.venv/bin/python3`.

The Python script talks to the User Env websocket controller at `ws://127.0.0.1:9001` and sends the setup commands:

- `bridge-start`
- `emulator-start`
- `emulator-setup`
- `background-check`

Running the Python script inside the container keeps the host machine free of extra Python package requirements. The container already has the `websockets` dependency that the controller client needs.

Use `send-json` for one-off controller commands:

```bash
./scripts/trezor-emulator send-json '{"type":"emulator-get-features"}'
```

On Apple Silicon, the helper installs `libsdl3-0` and `libsdl3-image0` inside the User Env container when they are missing.
