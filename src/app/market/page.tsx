import { redirect } from "next/navigation";

// The market view now lives in the terminal's watchlist.
export default function Market() {
  redirect("/");
}
