const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function POST(request: Request) {
  const res = await fetch(`${BACKEND}/datasets/preview`, {
    method: 'POST',
    body: request.body,
    headers: { 'content-type': request.headers.get('content-type') || '' },
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
