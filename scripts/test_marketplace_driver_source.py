import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('driver_source', Path(__file__).with_name('marketplace-driver-source.py'))
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)


class DriverIdentity(unittest.TestCase):
    def test_both_images_ship_the_actual_drivers_relative_module_closure(self):
        driver = ROOT/'marketplace/driver'
        imports = re.findall(r"from\s+['\"](\./[^'\"]+\.mjs)['\"]", (driver/'driver.mjs').read_text())
        self.assertTrue(imports)
        for name in ('Dockerfile', 'Dockerfile.staging'):
            with self.subTest(dockerfile=name), tempfile.TemporaryDirectory() as temp:
                image = Path(temp)
                for line in (driver/name).read_text().splitlines():
                    parts = shlex.split(line, comments=True)
                    if not parts or parts[0] != 'COPY' or parts[1].startswith('--from='):
                        continue
                    self.assertEqual(parts[-1], './')
                    for source_file in parts[1:-1]:
                        shutil.copyfile(driver/source_file, image/source_file)
                # Resolve/import the production relative modules using only the
                # files actually shipped by each Dockerfile, without npm, Docker,
                # private fixtures or server calls. Missing COPY inputs fail.
                script = 'for (const file of JSON.parse(process.argv[1])) await import(file);'
                result = subprocess.run(['node', '--input-type=module', '-e', script, json.dumps(imports)],
                                        cwd=image, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stdout+result.stderr)

    def test_every_local_copy_input_invalidates_identity_but_unrelated_files_do_not(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            shutil.copytree(ROOT/'marketplace/driver', root/'driver', ignore=shutil.ignore_patterns('node_modules', '.Dockerfile*'))
            root = root/'driver'; original = source.digest(root)
            for name in ('Dockerfile', 'driver.mjs', 'trust.mjs', 'payment-policy.mjs', 'seller-state.mjs', 'package.json', 'package-lock.json'):
                p=root/name; old=p.read_bytes();p.write_bytes(old+b'\n')
                self.assertNotEqual(source.digest(root), original, name)
                p.write_bytes(old)
            (root/'.operator-unrelated').write_text('not a build input')
            self.assertEqual(source.digest(root), original)

    def test_new_copy_inputs_are_included_and_escape_or_unknown_copy_is_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'Dockerfile').write_text('FROM image\nCOPY new.mjs ./\n')
            (root/'new.mjs').write_text('first'); first=source.digest(root)
            (root/'new.mjs').write_text('second');self.assertNotEqual(source.digest(root), first)
            for instruction in ('COPY ../outside ./', 'COPY --chmod=0755 new.mjs ./', 'COPY . ./'):
                (root/'Dockerfile').write_text(instruction+'\n')
                with self.assertRaises((ValueError, OSError)):source.digest(root)

    def test_actual_follow_app_cache_branch_rebuilds_old_driver_and_check_refuses_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'scripts').mkdir();(root/'marketplace/patches').mkdir(parents=True)
            (root/'marketplace/patches/paykit-server-test.patch').write_text('test patch identity')
            for name in ('follow-app-paykit', 'paykit-lock.py', 'marketplace-driver-source.py'):
                shutil.copyfile(ROOT/'scripts'/name, root/'scripts'/name)
            shutil.copytree(ROOT/'marketplace/driver', root/'marketplace/driver', ignore=shutil.ignore_patterns('node_modules', '.Dockerfile*'))
            expected=source.digest(root/'marketplace/driver')
            lock='\n'.join(f'[[package]]\nname = "{name}"\nversion = "0.1.0"\nsource = "git+https://github.com/pubky/{repo}.git?tag=v0.1.0#{revision}"\n' for name,repo,revision in [('paykit-lib','paykit-rs','b'*40),('paykit-sdk','paykit-rs','b'*40),('locks-core','locks','c'*40)])
            (root/'lock').write_text(lock)
            binary=root/'bin';binary.mkdir()
            (binary/'curl').write_text('''#!/usr/bin/env python3
import os,sys
from pathlib import Path
if 'gradle/libs.versions.toml' in sys.argv[-1]:print('paykit = { module = "com.synonym:paykit-android", version = "0.1.0" }')
elif sys.argv[-1].endswith('Cargo.lock'):print(Path(os.environ['TEST_LOCK']).read_text())
else:raise SystemExit('Unexpected network request')
''')
            (binary/'git').write_text('#!/usr/bin/env python3\nprint("b"*40+"\\trefs/tags/v0.1.0")\n')
            (binary/'docker').write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
a=sys.argv[1:]
if a[:2]==['compose','--profile']:
 print(json.dumps({'services':{n:{'image':'bitkit-docker/'+n+':test'} for n in ['payment-request-fixture','paykit-server','marketplace-driver']}}))
elif 'marketplace-driver-source' in ' '.join(a):
 p=Path(os.environ['TEST_BUILT']);print(p.read_text() if p.exists() else 'old-driver-source')
elif 'paykit-server-patches' in ' '.join(a):print('paykit-server-test.patch')
elif 'tech.masivo.paykit-rs' in ' '.join(a):print('b'*40)
elif 'tech.masivo.paykit-server' in ' '.join(a):print('a'*40)
elif a[0]=='tag':pass
else:raise SystemExit('Unexpected Docker operation: '+str(a))
''')
            (root/'pubky-marketplace').write_text('''#!/usr/bin/env python3
import os,sys
from pathlib import Path
assert sys.argv[1:]==['build-paykit']
assert os.environ['PAYKIT_RS_REV']=='b'*40
assert os.environ['PAYKIT_SERVER_REV']=='a'*40
Path(os.environ['TEST_BUILT']).write_text(os.environ['TEST_EXPECTED'])
''')
            for p in [*(binary.iterdir()),root/'pubky-marketplace']:p.chmod(0o755)
            env={**os.environ,'PATH':str(binary)+os.pathsep+os.environ['PATH'],'TEST_LOCK':str(root/'lock'),'TEST_BUILT':str(root/'built'),'TEST_EXPECTED':expected}
            argv=['bash',str(root/'scripts/follow-app-paykit'),'synonymdev/bitkit-android','d'*40]
            check=subprocess.run([*argv,'--check'],cwd=root,env=env,text=True,capture_output=True)
            self.assertEqual(check.returncode,3,check.stdout+check.stderr)
            self.assertFalse((root/'built').exists())
            repair=subprocess.run(argv,cwd=root,env=env,text=True,capture_output=True)
            self.assertEqual(repair.returncode,0,repair.stderr)
            self.assertEqual((root/'built').read_text(),expected)
            current=subprocess.run([*argv,'--check'],cwd=root,env=env,text=True,capture_output=True)
            self.assertEqual(current.returncode,0,current.stderr)


if __name__ == '__main__':unittest.main()
