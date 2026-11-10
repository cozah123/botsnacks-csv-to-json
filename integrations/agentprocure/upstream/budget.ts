import type { ServiceInfo, ServiceEndpoint } from "./discovery.js";



export interface PlannedCall {

  service: ServiceInfo; endpoint: ServiceEndpoint; estimatedCost: number; priority: number; reason: string;

  }

  export interface SkippedCall {

    service: ServiceInfo; endpoint: ServiceEndpoint; estimatedCost: number; reason: string;

    }

    export interface BudgetPlan {

      totalBudget: number; remainingBudget: number; plannedCalls: PlannedCall[]; skippedCalls: SkippedCall[]; reasoning: string;

      }



      export function createBudgetPlan(

        rankedEndpoints: Array<{ service: ServiceInfo; endpoint: ServiceEndpoint; relevanceScore: number }>,

          budget: number

          ): BudgetPlan {

            const planned: PlannedCall[] = [];

              const skipped: SkippedCall[] = [];

                let remaining = budget;

                  const reasoning: string[] = ["Starting budget: $" + budget.toFixed(2), "Found " + rankedEndpoints.length + " potential data sources"];



                    for (let i = 0; i < rankedEndpoints.length; i++) {

                        const { service, endpoint, relevanceScore } = rankedEndpoints[i];

                            const cost = parseFloat(endpoint.price.replace("$", ""));

                                if (cost > remaining) {

                                      skipped.push({ service, endpoint, estimatedCost: cost, reason: "Insufficient budget (need $" + cost + ", have $" + remaining.toFixed(4) + ")" });

                                            reasoning.push("SKIP " + service.name + endpoint.path + ": over budget");

                                                  continue;

                                                      }

                                                          const valueRatio = relevanceScore / cost;

                                                              if (valueRatio < 0.5 && planned.length >= 3) {

                                                                    skipped.push({ service, endpoint, estimatedCost: cost, reason: "Low value-to-cost ratio (" + valueRatio.toFixed(2) + ")" });

                                                                          reasoning.push("SKIP " + service.name + endpoint.path + ": low value ratio");

                                                                                continue;

                                                                                    }

                                                                                        planned.push({ service, endpoint, estimatedCost: cost, priority: i + 1, reason: "Relevance: " + relevanceScore.toFixed(1) + ", Cost: $" + cost + ", Value ratio: " + valueRatio.toFixed(2) });

                                                                                            remaining -= cost;

                                                                                                reasoning.push("PLAN " + service.name + endpoint.path + ": $" + cost + " (remaining: $" + remaining.toFixed(4) + ")");

                                                                                                  }

                                                                                                    reasoning.push("Plan: " + planned.length + " calls for $" + (budget - remaining).toFixed(4) + ", " + skipped.length + " skipped");

                                                                                                      return { totalBudget: budget, remainingBudget: remaining, plannedCalls: planned, skippedCalls: skipped, reasoning: reasoning.join("\n") };

        }
