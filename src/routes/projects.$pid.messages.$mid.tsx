import { createFileRoute } from '@tanstack/react-router'
import { MessageDetail } from '#/components/MessageDetail'

export const Route = createFileRoute('/projects/$pid/messages/$mid')({
  component: () => {
    const { pid, mid } = Route.useParams()
    return <MessageDetail projectId={pid} messageId={mid} />
  },
})
