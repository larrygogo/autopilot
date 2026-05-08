interface ProjectDetailProps {
  projectId: string;
}

export function ProjectDetail({ projectId }: ProjectDetailProps) {
  return <div>Project Detail: {projectId}</div>;
}
