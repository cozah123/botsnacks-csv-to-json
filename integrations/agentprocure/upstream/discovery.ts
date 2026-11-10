import OpenAI from "openai";

export interface ServiceEndpoint {
        path: string;
        method: string;
        price: string;
        description: string;
        params: Record<string, string>;
}

export interface ServiceInfo {
        service: string;
        name: string;
        description: string;
        baseUrl: string;
        endpoints: ServiceEndpoint[];
}

export interface RankedEndpoint {
        service: ServiceInfo;
        endpoint: ServiceEndpoint;
        relevanceScore: number;
}

// Discover all available x402-paywalled services (parallel with timeout)
export async function discoverServices(serviceUrls: string[]): Promise<ServiceInfo[]> {
        const services: ServiceInfo[] = [];

  const discoveries = await Promise.allSettled(
            serviceUrls.map(async (baseUrl) => {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 5000);
                        try {
                                      const res = await fetch(baseUrl + "/api/discover", { signal: controller.signal });
                                      clearTimeout(timeout);
                                      if (res.ok) {
                                                      const info = await res.json();
                                                      return { ...info, baseUrl } as ServiceInfo;
                                      }
                        } catch {
                                      console.warn("Could not discover service at " + baseUrl);
                        } finally {
                                      clearTimeout(timeout);
                        }
                        return null;
            })
          );

  for (const result of discoveries) {
            if (result.status === "fulfilled" && result.value) {
                        services.push(result.value);
            }
  }

  return services;
}

// Fast keyword-based relevance ranking
export function rankEndpointsByRelevance(
        services: ServiceInfo[],
        query: string
      ): RankedEndpoint[] {
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
        const ranked: RankedEndpoint[] = [];

  for (const service of services) {
            for (const endpoint of service.endpoints) {
                        let score = 0;
                        const text = [service.name, service.description, endpoint.description, endpoint.path]
                          .join(" ")
                          .toLowerCase();

              for (const kw of keywords) {
                            if (text.includes(kw)) score += 1;
                            // Partial match bonus for longer words
                          if (kw.length > 3) {
                                          const stem = kw.slice(0, -1);
                                          if (text.includes(stem) && !text.includes(kw)) score += 0.3;
                          }
              }

              // Depth bonus for premium analysis endpoints
              if (endpoint.path.includes("deep") || endpoint.path.includes("forecast") || endpoint.path.includes("competitor")) {
                            score += 0.5;
              }

              if (score > 0) ranked.push({ service, endpoint, relevanceScore: score });
            }
  }

  // Fallback: include everything with minimal score if no keyword matches
  if (ranked.length === 0) {
            for (const service of services) {
                        for (const endpoint of service.endpoints) {
                                      ranked.push({ service, endpoint, relevanceScore: 0.1 });
                        }
            }
  }

  return ranked.sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// LLM-powered smart ranking for complex queries
export async function rankEndpointsWithLLM(
        services: ServiceInfo[],
        query: string
      ): Promise<RankedEndpoint[]> {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const endpointList = services.flatMap((s) =>
            s.endpoints.map((e, i) => ({
                        id: s.service + ":" + i,
                        service: s.name,
                        endpoint: e.path,
                        description: e.description,
                        price: e.price,
            }))
                                          );

  try {
            const response = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: [
                              {
                                              role: "system",
                                              content:
                                                                "You are an API relevance scorer. Given a user query and a list of paid API endpoints, score each endpoint 0-10 for relevance. Return JSON: {\"rankings\": [{\"id\": \"...\", \"score\": N, \"reason\": \"...\"}]}. Be strict.",
                              },
                              {
                                              role: "user",
                                              content: "Query: " + query + "\n\nEndpoints:\n" + JSON.stringify(endpointList, null, 2),
                              },
                                    ],
                        response_format: { type: "json_object" },
                        max_tokens: 500,
                        temperature: 0,
            });

          const raw = JSON.parse(response.choices[0]?.message?.content || "{}");
            const scores: Array<{ id: string; score: number; reason: string }> =
                        raw.rankings || raw.scores || raw.results || [];

          if (scores.length === 0) {
                      return rankEndpointsByRelevance(services, query);
          }

          const ranked: RankedEndpoint[] = [];
            for (const s of scores) {
                        const [svcId, idxStr] = s.id.split(":");
                        const service = services.find((sv) => sv.service === svcId);
                        if (service) {
                                      const idx = parseInt(idxStr, 10);
                                      const endpoint = service.endpoints[idx];
                                      if (endpoint) {
                                                      ranked.push({ service, endpoint, relevanceScore: s.score / 10 });
                                      }
                        }
            }

          return ranked.sort((a, b) => b.relevanceScore - a.relevanceScore);
  } catch (error: any) {
            console.warn("LLM ranking failed, falling back to keyword ranking:", error.message);
            return rankEndpointsByRelevance(services, query);
  }
}
