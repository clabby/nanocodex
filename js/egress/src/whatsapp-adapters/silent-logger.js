// Protocol logs can contain pairing credentials and decrypted messages.
const logger = {level:'silent',child(){return this},trace(){},debug(){},info(){},warn(){},error(){},fatal(){}};
export default function createLogger() { return logger; }
