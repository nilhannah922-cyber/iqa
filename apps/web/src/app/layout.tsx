import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "iQA",
  description: "AI-assisted web page functional test automation",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
