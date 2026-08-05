export interface WebUsbConnectOptions {
  filters?: Array<{ vendorId?: number; productId?: number }>;
}

/**
 * Lazy WebUSB adapter. The browser-only package is deliberately not imported
 * by the core parser, so Node and browser bundlers can share the LBX/SVG API.
 * Call this from a secure Chromium context after a user gesture.
 */
export async function connectBrotherQlWebUsb(options: WebUsbConnectOptions = {}) {
  const driver = await import('@thermal-label/brother-ql-web');
  return driver.requestPrinter(options);
}
