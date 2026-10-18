import { redirect } from "next/navigation";

// Performance now lives in the terminal dock.
export default function Performance() {
  redirect("/?dock=performance");
}
