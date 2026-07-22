const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function POST() {
  const res = await fetch(`${BACKEND}/session/reset`, { method: 'POST' });
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
