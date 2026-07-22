const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function GET() {
  try {
    const res = await fetch(`${BACKEND}/pdf/ollama-models`);
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ detail: error.message || 'Ollama models proxy failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
