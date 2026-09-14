export function handleModelCatalogApiFallbackRequest(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}
