import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const arciumRoot = path.dirname(
  fileURLToPath(
    new URL(
      "./node_modules/@arcium-hq/client/package.json",
      import.meta.url
    )
  )
);

function arciumSourceResolver() {
  return {
    name: "b3-arcium-source-resolver",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !importer.startsWith(arciumRoot)) return null;
      if (source === "crypto") {
        return path.join(demoRoot, "src/browser-crypto-shim.js");
      }
      if (!source.endsWith(".js")) return null;
      const candidate = path.resolve(path.dirname(importer), source);
      const withoutExtension = candidate.slice(0, -3);
      if (fs.existsSync(`${withoutExtension}.ts`)) {
        return `${withoutExtension}.ts`;
      }
      if (fs.existsSync(`${withoutExtension}.js`)) {
        return `${withoutExtension}.js`;
      }
      return null;
    },
  };
}

export default {
  root: demoRoot,
  plugins: [arciumSourceResolver()],
  resolve: {
    alias: {
      "@arcium-hq/client/src": path.join(arciumRoot, "src"),
      crypto: path.join(demoRoot, "src/browser-crypto-shim.js"),
    },
  },
  build: {
    target: "es2022",
    outDir: path.join(demoRoot, "dist"),
    emptyOutDir: true,
  },
};
