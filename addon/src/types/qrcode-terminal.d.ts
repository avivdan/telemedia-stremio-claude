declare module 'qrcode-terminal' {
  function generate(text: string, options?: { small?: boolean }, callback?: (qr: string) => void): void;
  const qrcode: { generate: typeof generate };
  export default qrcode;
}
