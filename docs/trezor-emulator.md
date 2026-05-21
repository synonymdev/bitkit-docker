# Trezor Emulator Checks

Bitkit app PRs that need Trezor hardware behavior can use the official Trezor User Env through this repo. The helper starts the User Env without its extra regtest stack, starts Trezor Bridge, wipes a deterministic T2T1 emulator, and configures it with a stable seed and label.

## Start the Emulator

```bash
./scripts/trezor-emulator start
```

On macOS, the Trezor User Env service is part of the default compose stack, so `docker compose up -d` starts it with the rest of the Bitkit services. The helper is still useful because it resets Bridge and the emulator into the deterministic review state.

Linux needs host networking like upstream User Env, so its service stays behind the `trezor-linux` profile:

```bash
docker compose --profile trezor-linux up -d trezor-user-env-linux
```

If an upstream `trezor-user-env.mac` or `trezor-user-env.unix` container is already running, the helper reuses it instead of creating a duplicate container with the same fixed name.

The default emulator configuration is:

- model: `T2T1`
- firmware: `2-main`
- bridge: `node-bridge`
- mnemonic: `all all all all all all all all all all all all`
- pin: empty
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

- User Env dashboard: <http://localhost:9002>
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
./scripts/trezor-emulator logs
./scripts/trezor-emulator stop
```

Open the User Env dashboard at <http://localhost:9002>. Trezor Bridge listens at <http://localhost:21325>.

## How It Works

`scripts/trezor-emulator` is the entrypoint. It starts or reuses the User Env container, then runs `scripts/trezor-controller.py` inside that container with `/trezor-user-env/.venv/bin/python3`.

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
