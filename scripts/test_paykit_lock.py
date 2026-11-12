import hashlib
import importlib.util
import io
import json
import tarfile
import unittest
import sys
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("paykit_lock", Path(__file__).with_name("paykit-lock.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
REV = "a" * 40
LOCKS = "b" * 40


def archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as bundle:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            bundle.addfile(member, io.BytesIO(content))
    return output.getvalue()


class PaykitLockTests(unittest.TestCase):
    def setUp(self):
        self.crates = {}
        self.source = {}
        for name in ("paykit-lib", "paykit-sdk"):
            manifest = f'[package]\nname = "{name}"\nversion = "0.1.0"\n'.encode()
            rust = b"pub fn version() -> u8 { 1 }\n"
            files = {"Cargo.toml": manifest, "Cargo.toml.orig": manifest, "src/lib.rs": rust,
                     ".cargo_vcs_info.json": json.dumps({"git": {"sha1": REV}, "path_in_vcs": name}).encode()}
            self.crates[name] = files
            self.source[name + "/Cargo.toml"] = manifest
            self.source[name + "/src/lib.rs"] = rust

    def check(self, *, mutate_data=None, mutate_lock=None):
        packages, data = [], {}
        for name, files in self.crates.items():
            payload = archive({name + "-0.1.0/" + path: content for path, content in files.items()})
            data[f"https://static.crates.io/crates/{name}/{name}-0.1.0.crate"] = payload
            packages.append({'name': name, 'version': '0.1.0', 'source': helper.REGISTRY, 'checksum': hashlib.sha256(payload).hexdigest()})
        data["https://codeload.github.com/pubky/paykit-rs/tar.gz/" + REV] = archive({'paykit-rs-' + REV + '/' + path: content for path, content in self.source.items()})
        packages.append({'name': 'locks-core', 'version': '0.1.0-rc13', 'source': 'git+https://github.com/pubky/locks.git?tag=v0.1.0-rc13#' + LOCKS})
        if mutate_lock:
            mutate_lock(packages)
        if mutate_data:
            mutate_data(data)
        lock = '\n'.join('[[package]]\n' + '\n'.join(k + ' = ' + json.dumps(v) for k, v in p.items()) for p in packages)
        fetch = Mock(side_effect=data.__getitem__)
        result = helper.verify(lock, REV, fetch=fetch)
        return result, fetch

    def test_python310_uses_explicit_backport_or_actionable_dependency_error(self):
        # A 3.10 interpreter cannot import tomllib. Exercise that exact import
        # boundary using the compatible parser API, then parse a real Git lock.
        with patch.dict(sys.modules, {"tomllib": None, "tomli": helper.tomllib}):
            legacy = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(legacy)
            lock = "\n".join('[[package]]\nname = "' + name + '"\nversion = "0.1.0"\nsource = "git+https://github.com/pubky/' + repo + '.git?rev=' + revision + '#' + revision + '"' for name, repo, revision in [("paykit-lib", "paykit-rs", REV), ("paykit-sdk", "paykit-rs", REV), ("locks-core", "locks", LOCKS)])
            proof = legacy.verify(lock, REV)
            self.assertEqual(proof["locks"]["revision"], LOCKS)
        with patch.dict(sys.modules, {"tomllib": None, "tomli": None}):
            missing = importlib.util.module_from_spec(spec)
            with self.assertRaisesRegex(SystemExit, "apt-get install python3-tomli"):
                spec.loader.exec_module(missing)

    def test_registry_checksums_and_actual_packaged_source_match_the_app(self):
        proof, fetch = self.check()
        self.assertEqual(proof['locks']['revision'], LOCKS)
        self.assertEqual(proof['locks']['tag'], 'v0.1.0-rc13')
        self.assertEqual([p['name'] for p in proof['packages']], ['paykit-lib', 'paykit-sdk'])
        self.assertTrue(all('src/lib.rs' in p['comparedSourceFiles'] for p in proof['packages']))
        self.assertEqual(fetch.call_count, 3)

    def test_rejects_tampered_registry_bytes_before_using_provenance(self):
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.check(mutate_data=lambda data: data.update({next(iter(data)): b'tampered'}))

    def test_claimed_vcs_commit_does_not_substitute_for_matching_rust_source(self):
        self.crates['paykit-sdk']['src/lib.rs'] = b'pub fn version() -> u8 { 99 }\n'
        with self.assertRaisesRegex(ValueError, 'packaged source differs'):
            self.check()

    def test_rejects_mismatched_original_package_manifest(self):
        self.crates['paykit-lib']['Cargo.toml.orig'] += b'# uncommitted metadata\n'
        with self.assertRaisesRegex(ValueError, 'packaged source differs'):
            self.check()

    def test_rejects_wrong_or_dirty_vcs_metadata(self):
        for git in ({'sha1': 'c' * 40}, {'sha1': REV, 'dirty': True}):
            with self.subTest(git=git), self.assertRaisesRegex(ValueError, 'provenance'):
                self.crates['paykit-lib']['.cargo_vcs_info.json'] = json.dumps({'git': git, 'path_in_vcs': 'paykit-lib'}).encode()
                self.check()

    def test_git_tag_and_revision_sources_still_work_without_registry_downloads(self):
        def pins(packages):
            for index, package in enumerate(packages[:2]):
                package['source'] = 'git+https://github.com/pubky/paykit-rs.git?' + ('tag=v0.1.0' if index == 0 else 'rev=' + REV) + '#' + REV
        proof, fetch = self.check(mutate_lock=pins)
        self.assertTrue(all(p['source'] == 'git' for p in proof['packages']))
        fetch.assert_not_called()

    def test_rejects_one_matching_and_one_wrong_paykit_dependency(self):
        def pins(packages):
            packages[1]['source'] = 'git+https://github.com/pubky/paykit-rs.git?rev=' + 'c' * 40 + '#' + 'c' * 40
        with self.assertRaisesRegex(ValueError, 'Git revision differs'):
            self.check(mutate_lock=pins)

    def test_rejects_missing_or_ambiguous_paykit_packages(self):
        for mutate in (lambda packages: packages.pop(1), lambda packages: packages.append(dict(packages[0]))):
            with self.subTest(mutate=mutate), self.assertRaisesRegex(ValueError, 'Exactly one locked'):
                self.check(mutate_lock=mutate)

    def test_registry_locks_verifies_its_own_repository_source_and_checksum(self):
        name = 'locks-core'
        manifest = b'[package]\nname = "locks-core"\nversion = "0.1.0"\n'
        rust = b'pub const LOCK: u8 = 1;\n'
        crate = archive({'locks-core-0.1.0/Cargo.toml': manifest,
                         'locks-core-0.1.0/Cargo.toml.orig': manifest,
                         'locks-core-0.1.0/src/lib.rs': rust,
                         'locks-core-0.1.0/.cargo_vcs_info.json': json.dumps({'git': {'sha1': LOCKS}, 'path_in_vcs': name}).encode()})
        package = {'name': name, 'version': '0.1.0', 'source': helper.REGISTRY, 'checksum': hashlib.sha256(crate).hexdigest()}
        data = {'https://static.crates.io/crates/locks-core/locks-core-0.1.0.crate': crate,
                'https://codeload.github.com/pubky/locks/tar.gz/' + LOCKS: archive({'locks-' + LOCKS + '/locks-core/Cargo.toml': manifest, 'locks-' + LOCKS + '/locks-core/src/lib.rs': rust})}
        proof = helper.package_proof(package, 'locks', None, cache=None, fetch=data.__getitem__, sources={})
        self.assertEqual(proof['revision'], LOCKS)
        self.assertEqual(proof['tag'], 'v0.1.0')
        self.assertIn('src/lib.rs', proof['comparedSourceFiles'])
        package['checksum'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'checksum'):
            helper.package_proof(package, 'locks', None, cache=None, fetch=data.__getitem__, sources={})

    def test_repository_document_links_are_ignored_without_following_them(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode='w:gz') as bundle:
            link = tarfile.TarInfo('repository/CLAUDE.md')
            link.type = tarfile.SYMTYPE
            link.linkname = 'AGENTS.md'
            bundle.addfile(link)
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            helper.archive_files(output.getvalue())
        self.assertEqual(helper.archive_files(output.getvalue(), allow_links=True), {})

    def test_rejects_foreign_locks_source_and_unsafe_archive_paths(self):
        with self.assertRaisesRegex(ValueError, 'Unexpected Git'):
            self.check(mutate_lock=lambda packages: packages[-1].update(source='git+https://example.com/locks.git#' + LOCKS))
        with self.assertRaisesRegex(ValueError, 'Unsafe'):
            helper.archive_files(archive({'root/../../outside.rs': b'no'}))


if __name__ == '__main__':
    unittest.main()
