import { createFileRoute } from "@tanstack/react-router";
import { Predictor } from "@/components/predictor";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Predictor />;
}
