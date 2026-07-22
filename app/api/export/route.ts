const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function POST(request: Request) {
  const res = await fetch(`${BACKEND}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  });
  if (!res.ok) {
    // Error bodies are JSON ({detail: string}) — pass them through for the client.
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Disposition': res.headers.get('Content-Disposition') || 'attachment',
      'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
}
