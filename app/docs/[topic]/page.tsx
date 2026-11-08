import { notFound } from "next/navigation";
import { DocsPage } from "@/components/nabda/docs";
export default async function Doc({params}:{params:Promise<{topic:string}>}){const {topic}=await params;if(!["quickstart","installation","authentication","messages","status","testing","phone-queue","limits"].includes(topic))notFound();return <DocsPage topic={topic}/>;}
