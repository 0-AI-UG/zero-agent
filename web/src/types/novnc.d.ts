declare module "@novnc/novnc/lib/rfb" {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: {
        shared?: boolean;
        credentials?: { password?: string };
        wsProtocols?: string[];
      },
    );
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    addEventListener(event: string, handler: (e: any) => void): void;
    removeEventListener(event: string, handler: (e: any) => void): void;
  }
}
