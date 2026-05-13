import { createFileRoute } from '@tanstack/react-router'
import { MessageDetail } from '#/components/MessageDetail'

export const Route = createFileRoute('/sessions/$sid/messages/$mid')({
  component: () => {
    const { sid, mid } = Route.useParams()
    return <MessageDetail sessionId={sid} messageId={mid} />
  },
})
