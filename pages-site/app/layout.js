import { Open_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "./components/AppShell";

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "OrientMe",
  description: "Turns scattered work information into a short, evidence-linked brief.",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`${openSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-cream">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
