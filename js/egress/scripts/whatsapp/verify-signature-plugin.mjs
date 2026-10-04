import { readFile } from 'node:fs/promises';
// Baileys rc14 expects rejection by throw, while libsignal 6 returns false.
// Preserve the maintained verifier and reject its explicit false result.
export const verifySignaturePlugin = {name:'baileys-libsignal-verification',setup(build){
  build.onLoad({filter:/@whiskeysockets\/baileys\/lib\/Utils\/crypto\.js$/},async ({path})=>{
    const source=await readFile(path,'utf8');
    const old='curve.verifySignature(generateSignalPubKey(pubKey), message, signature);';
    if(!source.includes(old))throw new Error('Baileys verification adapter requires review after upgrade');
    let patched = source.replace(old,'if (curve.verifySignature(generateSignalPubKey(pubKey), message, signature) === false) return false;');
    // workerd's node:crypto empty-AAD call fails GCM authentication. Omitting
    // zero-length AAD is the identical AEAD input and preserves native crypto.
    for (const name of ['cipher', 'decipher']) {
      const aad = `${name}.setAAD(additionalData);`;
      if (!patched.includes(aad)) throw new Error('Baileys GCM adapter requires review after upgrade');
      patched = patched.replace(aad, `if (additionalData.byteLength) ${aad}`);
    }
    return {contents:patched,loader:'js'};
  });
}};
