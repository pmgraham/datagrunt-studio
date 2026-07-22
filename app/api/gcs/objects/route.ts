const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function GET(request: Request) {
  const { search } = new URL(request.url);
  const res = await fetch(`${BACKEND}/gcs/objects${search}`, { cache: 'no-store' });
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
