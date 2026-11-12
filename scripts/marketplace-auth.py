#!/usr/bin/env python3
"""Split-phase seller authorization using one owned Compose run container.

The grant listener must stay alive while a device approves its URL. A durable
intent and deterministic container name prevent a lost start response from
creating a second listener. Status never starts or replays an operation.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

LABEL = "to.bitkit.marketplace-auth"


class AuthOperations:
    def __init__(self, root, project, image, run=subprocess.run):
        self.root = Path(root).resolve()
        self.directory = self.root / ".marketplace/auth-operations"
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.project, self.image, self.run = project, image, run
        self.owner = hashlib.sha256((str(self.root) + "\0" + project).encode()).hexdigest()

    def docker(self, *args, missing=False):
        result = self.run(["docker", *args], cwd=self.root, text=True,
                          capture_output=True, timeout=60)
        if result.returncode:
            if missing and "No such" in result.stderr:
                return None
            # Docker arguments contain only public command configuration.
            raise RuntimeError("Docker operation failed: " + result.stderr[-2000:])
        return result.stdout.strip()

    def path(self, operation):
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", operation):
            raise ValueError("Use a stable lowercase operation id (1–40 characters)")
        return self.directory / (operation + ".json")

    def write(self, path, value):
        temporary = path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def inspect(self, record):
        raw = self.docker("container", "inspect", record["container"], missing=True)
        if raw is None:
            return None
        container = json.loads(raw)[0]
        labels = container["Config"].get("Labels") or {}
        if (labels.get(LABEL + ".owner") != self.owner
                or labels.get(LABEL + ".intent") != record["fingerprint"]
                or labels.get("com.docker.compose.project") != self.project
                or container["Image"] != record["imageId"]):
            raise RuntimeError("Authorization container ownership/image mismatch; left untouched")
        return container

    def status(self, operation):
        path = self.path(operation)
        if not path.exists():
            raise ValueError("Unknown authorization operation")
        record = json.loads(path.read_text())
        container = self.inspect(record)
        if container is None:
            return {"operation": operation, "status": "uncertain",
                    "detail": "Container is absent; this operation will not be replayed"}
        logged = self.run(["docker", "logs", "--tail", "20", record["container"]],
                          cwd=self.root, text=True, capture_output=True, timeout=60)
        if logged.returncode:
            raise RuntimeError("Could not read the owned authorization listener log")
        # Non-TTY Docker logs separates driver errors onto stderr.
        logs = logged.stdout + "\n" + logged.stderr
        events = []
        for line in logs.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(event, dict) and event.get("status") in ("awaiting_approval", "approved"):
                events.append(event)
        state = container["State"]
        if state["Running"]:
            return {**(events[-1] if events else {"status": "starting"}),
                    "operation": operation}
        if state["ExitCode"] == 0 and events and events[-1]["status"] == "approved":
            return {**events[-1], "operation": operation}
        # Never echo raw grant URLs or error logs in a failed terminal response.
        reason = "grant-listener-failed"
        for needle, code in (("fixture is not seeded", "fixture-not-seeded"),
                             ("no seller yet", "fixture-not-seeded"),
                             ("no approval within", "approval-timeout"),
                             ("does not allow writing", "grant-capability-mismatch"),
                             ("restores to another identity", "grant-identity-mismatch")):
            if needle in logs:
                reason = code
                break
        return {"operation": operation, "status": "failed", "exitCode": state["ExitCode"],
                "reason": reason}

    def start(self, operation, args):
        path = self.path(operation)
        argv = ["seller-auth", *args]
        image = json.loads(self.docker("image", "inspect", self.image))[0]["Id"]
        intent = {"owner": self.owner, "project": self.project, "imageId": image, "argv": argv,
                  "lockPolicy": os.environ.get("MARKETPLACE_LOCK_POLICY", "legacy")}
        fingerprint = hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()
        if path.exists():
            if json.loads(path.read_text())["fingerprint"] != fingerprint:
                raise ValueError("Operation id already belongs to different arguments/image")
            return self.status(operation)
        name = "marketplace-auth-" + self.owner[:12] + "-" + operation
        # Check the namespace before recording intent; never adopt an unowned name.
        collision = self.docker("container", "inspect", name, missing=True)
        if collision is not None:
            raise RuntimeError("Authorization container name already exists; left untouched")
        record = {**intent, "container": name, "fingerprint": fingerprint}
        self.write(path, record)  # BEFORE Docker: uncertain outcomes are never blindly retried.
        self.docker("compose", "--profile", "marketplace", "run", "-d", "--no-deps",
                    "--quiet-build", "-T", "--name", name,
                    "--label", LABEL + ".owner=" + self.owner,
                    "--label", LABEL + ".intent=" + fingerprint,
                    "-e", "MARKETPLACE_HOST_UID=" + str(os.getuid()),
                    "-e", "MARKETPLACE_HOST_GID=" + str(os.getgid()),
                    "marketplace-driver", *argv)
        return self.status(operation)

    def cleanup(self):
        removed = []
        for path in sorted(self.directory.glob("*.json")):
            record = json.loads(path.read_text())
            if self.inspect(record) is not None:
                self.docker("rm", "-f", record["container"])
            path.unlink()
            removed.append(path.stem)
        return {"removed": removed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("action", choices=("start", "status", "cleanup"))
    parser.add_argument("operation", nargs="?")
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--serial")
    parser.add_argument("--relay")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 900:
        parser.error("Authorization timeout must be 1–900 seconds")
    manager = AuthOperations(Path.cwd(), args.project, args.image)
    with (manager.directory / ".lock").open("a+") as lock:
        os.chmod(manager.directory / ".lock", 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        if args.action == "cleanup":
            result = manager.cleanup()
        elif not args.operation:
            parser.error("A stable operation id is required")
        elif args.action == "status":
            result = manager.status(args.operation)
        else:
            argv = ["--timeout", str(args.timeout)]
            for name in ("serial", "relay"):
                value = getattr(args, name)
                if value:
                    argv += ["--" + name, value]
            result = manager.start(args.operation, argv)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
