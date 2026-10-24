import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "wayfinder starchart",
  description: "Wayfinder maps as a star-map, with T3 Code sessions a click away",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
