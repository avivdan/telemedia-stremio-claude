declare module 'stremio-addon-sdk' {
  export class addonBuilder {
    constructor(manifest: object);
    defineCatalogHandler(handler: Function): void;
    defineMetaHandler(handler: Function): void;
    defineStreamHandler(handler: Function): void;
    getInterface(): object;
  }
  export function getRouter(addonInterface: object): Function;
  export function serveHTTP(addonInterface: object, options?: { port?: number }): void;
}
