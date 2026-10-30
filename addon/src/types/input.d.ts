declare module 'input' {
  function text(message: string, options?: Record<string, unknown>): Promise<string>;
  function password(message: string, options?: Record<string, unknown>): Promise<string>;
  function confirm(message: string, options?: Record<string, unknown>): Promise<boolean>;
  function select(message: string, choices: string[], options?: Record<string, unknown>): Promise<string>;
  export { text, password, confirm, select };
  export default { text, password, confirm, select };
}
