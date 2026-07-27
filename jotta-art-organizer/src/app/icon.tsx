import { ImageResponse } from 'next/og'

export const size = { width: 192, height: 192 }
export const contentType = 'image/png'

export default function Icon() {
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
          borderRadius: 36,
        }}
      >
        <div
          style={{
            fontSize: 108,
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
