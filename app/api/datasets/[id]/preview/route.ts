const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const limit = new URL(request.url).searchParams.get('limit') ?? '1000';
  const res = await fetch(`${BACKEND}/datasets/${id}/preview?limit=${encodeURIComponent(limit)}`);
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
