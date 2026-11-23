import { handleApi } from '../core/http.ts';

export default {
  fetch(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname === '/api/dispatch'
      ? url.searchParams.get('__route') ?? ''
      : url.pathname.slice('/api/'.length);
    return handleApi(request, path.replace(/\/$/, ''));
  },
};
