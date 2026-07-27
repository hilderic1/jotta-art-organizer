import { ImageResponse } from 'next/og'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #4f46e5, #0ea5e9)',
        }}
      >
        <div
          style={{
            fontSize: 100,
            fontWeight: 700,
            color: 'white',
            fontFamily: 'sans-serif',
          }}
        >
          J
        </div>
      </div>
    ),
    { ...size }
  )
}
