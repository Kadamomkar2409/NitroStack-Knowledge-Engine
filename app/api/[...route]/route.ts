import { handleApi } from '../../../backend/core/http.ts';

export const runtime = 'nodejs';
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

type Route = { params: Promise<{ route: string[] }> };

async function handle(request: Request, { params }: Route) {
  const { route } = await params;
  return handleApi(request, route.join('/'));
}

export { handle as GET, handle as POST, handle as DELETE };
