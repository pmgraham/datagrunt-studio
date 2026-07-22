const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await fetch(`${BACKEND}/datasets/${id}`, { method: 'DELETE' });
  return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json' } });
}
