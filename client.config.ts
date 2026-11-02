// 浏览器产物使用宿主 ModuleLoader 的工厂格式，React 由宿主共享。
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { client: 'src/plugins/client.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser',
  target: 'es2022', fixedExtension: false, clean: false, dts: false,
  deps: { alwaysBundle: ['zod', /^@deepseek-ai\/dsh-typert-protocol/], neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
  outputOptions: {
    entryFileNames: '[name].js',
    banner: 'window.__ModuleLoader__.load({id:"dsh-plugin-acn",factory:(require)=>{var module={exports:{}};var exports=module.exports;',
    footer: 'return module.exports;}});',
  },
});
