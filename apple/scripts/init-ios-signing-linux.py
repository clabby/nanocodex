#!/usr/bin/env python3
"""Create a local Linux RSA key + CSR, never an Apple-issued certificate.

No Apple login, certificate issuance/revocation, key export, upload or signing.
The private key stays mode 0600 in a NEW mode 0700 external directory. Only the
CSR/public fingerprint may be taken to an authorized Apple Developer account.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]

def require(condition, message):
    if not condition:
        raise ValueError(message)

def safe_path(path):
    lexical = path.expanduser()
    if not lexical.is_absolute(): lexical = Path.cwd() / lexical
    require(not any(p.is_symlink() for p in (lexical, *lexical.parents)), 'Symlink paths are forbidden.')
    return Path(os.path.abspath(lexical))

def run(command, failure):
    # Never expose tool diagnostics: commands reading a key can report private data.
    value = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(value.returncode == 0, failure)
    return value.stdout

def rename_new(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    require(hasattr(libc, 'renameat2'), 'Linux atomic no-replace rename is required.')
    call = libc.renameat2
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int
    if call(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        raise OSError(ctypes.get_errno(), 'Atomic publication refused.')

def create(directory, common_name, email=None):
    require(sys.platform == 'linux', 'Linux is required.')
    require(shutil.which('openssl'), 'OpenSSL is required.')
    require(isinstance(common_name,str) and 1 <= len(common_name) <= 128 and
            re.fullmatch(r'[A-Za-z0-9 ._@-]+',common_name) and common_name.strip() == common_name,
            'Common name must be 1-128 safe ASCII characters; no DN injection or controls.')
    require(email is None or (len(email) <= 254 and re.fullmatch(r'[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+',email)),
            'Invalid optional email.')
    directory = safe_path(directory)
    require(not directory.is_relative_to(Path('/brain')) and not any(p.name == 'outputs' for p in (directory,*directory.parents)),
            'Private keys may not be stored in /brain or artifact outputs.')
    require(not directory.is_relative_to(REPO) and not REPO.is_relative_to(directory), 'Private directory must be outside the repository.')
    require(directory.parent.is_dir(), 'Private directory parent must already exist.')
    require(not directory.exists(), 'Private directory must be NEW; existing keys are never replaced.')
    with tempfile.TemporaryDirectory(prefix='.ios-csr-', dir=directory.parent) as temporary:
        stage=Path(temporary)/'private';stage.mkdir(mode=0o700);os.chmod(stage,0o700)
        key=stage/'signing-key.pem';csr=stage/'request.certSigningRequest'
        subject='/CN='+common_name+('/emailAddress='+email if email else '')
        # RSA2048 matches upstream xtool signing key generation. SHA256 CSR is
        # standard PKCS#10; acceptance/issuance by Apple is NOT claimed here.
        run(['openssl','req','-new','-newkey','rsa:2048','-sha256','-nodes','-batch',
             '-subj',subject,'-keyout',str(key),'-out',str(csr)], 'Key/CSR generation failed; nothing published.')
        os.chmod(key,0o600);os.chmod(csr,0o600)
        run(['openssl','pkey','-in',str(key),'-passin','pass:','-check','-noout'], 'Generated key validation failed.')
        run(['openssl','req','-in',str(csr),'-verify','-noout'], 'Generated CSR self-signature failed.')
        key_public=run(['openssl','pkey','-in',str(key),'-passin','pass:','-pubout'], 'Generated public key unavailable.')
        csr_public=run(['openssl','req','-in',str(csr),'-pubkey','-noout'], 'CSR public key unavailable.')
        require(key_public==csr_public,'CSR/key mismatch.')
        fingerprint=hashlib.sha256(key_public).hexdigest()
        report={'status':'local-csr-created-apple-issuance-pending','algorithm':'RSA2048',
                'csr_signature':'sha256WithRSAEncryption','csr_sha256':hashlib.sha256(csr.read_bytes()).hexdigest(),
                'public_key_pem_sha256':fingerprint,'private_key_file':'signing-key.pem',
                'csr_file':'request.certSigningRequest','apple_certificate_issued':False,
                'apple_network_requests':0,'private_key_exported':False}
        metadata=stage/'bootstrap.json';metadata.write_text(json.dumps(report,indent=2)+'\n');os.chmod(metadata,0o600)
        safe_path(directory)
        rename_new(stage,directory)
    return {'status':report['status'],'csr':str(directory/'request.certSigningRequest'),
            'public_key_pem_sha256':fingerprint,'private_directory_mode':'0700','private_key_mode':'0600',
            'apple_certificate_issued':False,'private_key_exported':False}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True,help='NEW private directory outside the repo; never /brain or outputs')
    parser.add_argument('--common-name',required=True,help='Non-secret local label, safe ASCII')
    parser.add_argument('--email',help='Optional non-secret CSR email')
    args=parser.parse_args()
    print(json.dumps(create(args.directory,args.common_name,args.email),sort_keys=True))

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,TypeError) as error:
        raise SystemExit('Linux signing bootstrap refused: '+(str(error) if isinstance(error,ValueError) else type(error).__name__))
