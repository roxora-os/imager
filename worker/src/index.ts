// Entry point of the Worker. The logic is in proxy.ts: the runtime treats
// every named export of this file as an entry point, so it has only the
// default one.
import { handle } from './proxy';

export default {
  fetch(req: Request): Promise<Response> {
    return handle(req);
  },
};
