import { build } from '@sharkord/plugin-builder';
import manifest from './manifest.json';

await build({
  sdkVersion: manifest.sdkVersion
});
