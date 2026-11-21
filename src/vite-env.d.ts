/// <reference types="vite/client" />

declare module '*?raw' {
  const source: string;
  export default source;
}

declare module '*.py?raw' {
  const source: string;
  export default source;
}

interface Navigator {
  deviceMemory?: number;
}
