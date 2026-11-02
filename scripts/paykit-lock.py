#!/usr/bin/env python3
"""Verify a server's locked Paykit packages against an exact app source revision."""

import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

try:
    import tomllib
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError:
        raise SystemExit("Paykit lock verification needs Python 3.11+ or tomli (Ubuntu: apt-get install python3-tomli)") from None

SHA = re.compile(r"[0-9a-f]{40}")
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def download(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError("Provenance download exceeds the bounded package size")
    return data


def cached(url, path, fetch):
    if path is not None and path.exists():
        return path.read_bytes()
    data = fetch(url)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
    return data


def archive_files(data, *, allow_links=False):
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        total = 0
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe provenance archive entry")
            if member.issym() or member.islnk():
                if allow_links:
                    continue  # GitHub archives may link documentation; never follow it.
                raise ValueError("Unsafe provenance archive entry")
            if not member.isfile():
                continue
            if len(path.parts) < 2:
                raise ValueError("Missing package archive root")
            name = str(PurePosixPath(*path.parts[1:]))
            if name in files:
                raise ValueError("Duplicate provenance archive file")
            total += member.size
            if total > 128 * 1024 * 1024:
                raise ValueError("Provenance archive expands beyond its size bound")
            files[name] = archive.extractfile(member).read()
    return files


def git_pin(package, repository):
    source = package.get("source", "")
    prefix = "git+https://github.com/pubky/" + repository + ".git"
    if source.split("?", 1)[0].split("#", 1)[0] != prefix:
        raise ValueError("Unexpected Git dependency source for " + package["name"])
    parsed = urllib.parse.urlsplit(source[4:])
    if not SHA.fullmatch(parsed.fragment):
        raise ValueError("Dependency needs an exact Git commit")
    return parsed.fragment, urllib.parse.parse_qs(parsed.query)


def package_proof(package, repository, revision, *, cache, fetch, sources):
    name = package["name"]
    if package.get("source", "").startswith("git+"):
        pin, query = git_pin(package, repository)
        if revision is not None and pin != revision:
            raise ValueError(name + " Git revision differs from the app")
        return {"name": name, "source": "git", "revision": pin,
                "version": package["version"], "tag": query.get("tag", ["v" + package["version"]])[0]}
    if package.get("source") != REGISTRY:
        raise ValueError("Unsupported package source for " + name)
    version, checksum = package["version"], package.get("checksum", "")
    if not re.fullmatch(r"[0-9A-Za-z.+-]+", version) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise ValueError("Registry package needs a valid version and locked checksum")
    data = cached(
        f"https://static.crates.io/crates/{name}/{name}-{version}.crate",
        cache / f"{name}-{version}-{checksum}.crate" if cache else None,
        fetch,
    )
    if hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError(name + " registry checksum differs from Cargo.lock")
    crate = archive_files(data)
    vcs = json.loads(crate[".cargo_vcs_info.json"])
    actual = vcs.get("git", {}).get("sha1", "")
    if not SHA.fullmatch(actual) or revision is not None and actual != revision or vcs.get("git", {}).get("dirty", False) is not False or vcs.get("path_in_vcs") != name:
        raise ValueError(name + " package provenance differs from the clean app revision")
    manifest = tomllib.loads(crate["Cargo.toml"].decode())
    if manifest["package"]["name"] != name or manifest["package"]["version"] != version:
        raise ValueError("Registry package identity differs from Cargo.lock")
    identity = (repository, actual)
    if identity not in sources:
        sources[identity] = archive_files(cached(
            f"https://codeload.github.com/pubky/{repository}/tar.gz/{actual}",
            cache / f"{repository}-{actual}.tar.gz" if cache else None,
            fetch,
        ), allow_links=True)
    source = sources[identity]
    # VCS metadata alone does not prove a package matches its Git source.
    # Compare the original manifest and every packaged Rust/source file too.
    compared = []
    for path, content in crate.items():
        if path == "Cargo.toml.orig" or path.startswith("src/") or path.endswith(".rs"):
            original = "Cargo.toml" if path == "Cargo.toml.orig" else path
            if source.get(name + "/" + original) != content:
                raise ValueError(name + " packaged source differs from the pinned Git tree: " + path)
            compared.append(path)
    if "Cargo.toml.orig" not in compared or not any(p.startswith("src/") for p in compared):
        raise ValueError("Registry package lacks verifiable source files")
    return {"name": name, "source": "registry", "version": version, "checksum": checksum,
            "revision": actual, "tag": "v" + version, "comparedSourceFiles": sorted(compared)}


def verify(lock, revision, *, cache=None, fetch=download):
    if not SHA.fullmatch(revision):
        raise ValueError("A full app Paykit revision is required")
    packages = tomllib.loads(lock)["package"]
    sources = {}

    def one(name):
        matches = [p for p in packages if p["name"] == name]
        if len(matches) != 1:
            raise ValueError("Exactly one locked " + name + " is required")
        return matches[0]

    proofs = [package_proof(one(name), "paykit-rs", revision, cache=cache, fetch=fetch, sources=sources)
              for name in ("paykit-lib", "paykit-sdk")]
    locks = package_proof(one("locks-core"), "locks", None, cache=cache, fetch=fetch, sources=sources)
    if not re.fullmatch(r"[0-9A-Za-z_.+-]+", locks["tag"]):
        raise ValueError("Unsafe Locks tag")
    return {"paykitRevision": revision, "packages": proofs,
            "locks": {"revision": locks["revision"], "tag": locks["tag"], "provenance": locks}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--lock", type=Path)
    inputs.add_argument("--pins", type=Path, help="Validate saved public build pins and emit safe fields")
    parser.add_argument("--paykit-rev")
    parser.add_argument("--locks-rev")
    parser.add_argument("--locks-tag")
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    try:
        if args.pins:
            pins = json.loads(args.pins.read_text())
            fields = [pins[key] for key in ("serverRevision", "paykitRevision", "paykitTag", "locksRevision", "locksTag")]
            if not all(isinstance(value, str) for value in fields) or not all(SHA.fullmatch(fields[i]) for i in (0, 1, 3)) or not all(re.fullmatch(r"[0-9A-Za-z_.+-]+", fields[i]) for i in (2, 4)):
                raise ValueError("Saved build pins are malformed")
            print(" ".join(fields))
            return
        if not args.paykit_rev:
            parser.error("--paykit-rev is required with --lock")
        lock = sys.stdin.read() if args.lock == Path("-") else args.lock.read_text()
        result = verify(lock, args.paykit_rev, cache=args.cache)
        if args.locks_rev and result["locks"]["revision"] != args.locks_rev:
            raise ValueError("Locks revision differs from the configured build")
        if args.locks_tag and result["locks"]["tag"] != args.locks_tag:
            raise ValueError("Locks tag differs from the configured build")
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        parser.exit(4, "Paykit dependency alignment failed: " + str(error) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
