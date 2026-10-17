import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./resolve-three.mjs', import.meta.url), pathToFileURL('./'));
