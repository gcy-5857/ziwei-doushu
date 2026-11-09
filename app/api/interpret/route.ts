import { handleInterpret } from '@/lib/interpret/handle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export function POST(request: Request): Promise<Response> {
  return handleInterpret(request);
}
