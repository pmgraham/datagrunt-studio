const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function GET() {
  const res = await fetch(`${BACKEND}/gcs/projects`, { cache: 'no-store' });
  return new Response(await res.text(), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
