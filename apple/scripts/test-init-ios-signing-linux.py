#!/usr/bin/env python3
"""Real OpenSSL local-key/CSR tests; NOT Apple issuance or signing evidence."""
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('bootstrap',ROOT/'apple/scripts/init-ios-signing-linux.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='csr-test-',dir=ROOT.parent);self.root=Path(self.temp.name);self.out=self.root/'private'
 def tearDown(self):self.temp.cleanup()
 def test_real_csr_and_key_stay_private(self):
  report=m.create(self.out,'Nanocodex test fixture','test@example.test')
  self.assertEqual(report['status'],'local-csr-created-apple-issuance-pending')
  self.assertEqual(stat.S_IMODE(self.out.stat().st_mode),0o700)
  for p in self.out.iterdir():self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o600)
  self.assertNotIn('PRIVATE KEY',json.dumps(report))
  self.assertFalse(report['apple_certificate_issued']);self.assertFalse(report['private_key_exported'])
  old={p.name:p.read_bytes() for p in self.out.iterdir()}
  with self.assertRaises(ValueError):m.create(self.out,'different')
  self.assertEqual(old,{p.name:p.read_bytes() for p in self.out.iterdir()})
  self.assertEqual(subprocess.run(['openssl','req','-in',str(self.out/'request.certSigningRequest'),'-verify','-noout'],capture_output=True).returncode,0)
 def test_bad_paths_and_dn_injection(self):
  for label in ('','bad/CN=injected','bad\nname','bad\\name',' '+ 'name','x'*129):
   with self.assertRaises(ValueError):m.create(self.out,label)
  with self.assertRaises(ValueError):m.create(self.out,'name','email/bad@example.test')
  with self.assertRaises(ValueError):m.create(ROOT/'forbidden-private','name')
  with self.assertRaises(ValueError):m.create(Path('/brain/tmp/private-key-forbidden'),'name')
  with self.assertRaises(ValueError):m.create(self.root/'outputs'/'private','name')
  link=self.root/'link';link.symlink_to(self.root,target_is_directory=True)
  with self.assertRaises(ValueError):m.create(link/'..'/self.root.name/'private','name')
  self.assertFalse(self.out.exists())
 def test_failure_cleanup(self):
  with patch.object(m,'run',side_effect=ValueError('synthetic failure')):
   with self.assertRaises(ValueError):m.create(self.out,'name')
  self.assertFalse(self.out.exists());self.assertEqual(list(self.root.iterdir()),[])
 def test_destination_race_never_overwrites(self):
  original=m.rename_new
  def race(src,dst):
   dst.mkdir();(dst/'keep').write_text('immutable');original(src,dst)
  with patch.object(m,'rename_new',side_effect=race):
   with self.assertRaises(OSError):m.create(self.out,'name')
  self.assertEqual((self.out/'keep').read_text(),'immutable')
  self.assertEqual([p.name for p in self.root.iterdir()],['private'])
if __name__=='__main__':unittest.main(verbosity=2)
