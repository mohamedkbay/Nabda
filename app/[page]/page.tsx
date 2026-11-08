import { notFound } from "next/navigation";
import { SupportPage, HowPage, DownloadPage, HelpPage, PolicyPage } from "@/components/nabda/pages";
import { DocsPage } from "@/components/nabda/docs";
import { Dashboard } from "@/components/nabda/dashboard";
export default async function Page({params}:{params:Promise<{page:string}>}){const {page}=await params;switch(page){case "support":return <SupportPage/>;case "how-it-works":return <HowPage/>;case "download":return <DownloadPage/>;case "help":return <HelpPage/>;case "privacy":return <PolicyPage kind="privacy"/>;case "terms":return <PolicyPage kind="terms"/>;case "docs":return <DocsPage topic="quickstart"/>;case "dashboard":return <Dashboard signInPath="/signin-with-chatgpt?return_to=%2Fdashboard" signInLabel="Continue with ChatGPT"/>;default:notFound();}}
