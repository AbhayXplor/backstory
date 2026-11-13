import { Map as MlMap, Marker, NavigationControl, setWorkerUrl, type MapMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef } from 'react'

type Point = { lat: number; lon: number }

setWorkerUrl('/maplibre-gl-worker.mjs')

export default function MapPicker({
  point,
  onPick,
  className,
}: {
  point: Point | null
  onPick: (p: Point) => void
  className?: string
}) {
  const holder = useRef<HTMLDivElement | null>(null)
  const map = useRef<MlMap | null>(null)
  const marker = useRef<Marker | null>(null)
  const pick = useRef(onPick)
  pick.current = onPick

  useEffect(() => {
    if (!holder.current || map.current) return
    const m = new MlMap({
      container: holder.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [55.2708, 25.2048],
      zoom: 10.6,
      attributionControl: { compact: true },
    })
    m.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    m.on('click', (e: MapMouseEvent) => pick.current({ lat: e.lngLat.lat, lon: e.lngLat.lng }))
    map.current = m
    return () => {
      m.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    if (!map.current || !point) return
    if (!marker.current) {
      marker.current = new Marker({ color: '#1c5c46' })
    }
    marker.current.setLngLat([point.lon, point.lat]).addTo(map.current)
    map.current.flyTo({ center: [point.lon, point.lat], zoom: 14.4, speed: 1.15 })
  }, [point])

  return <div ref={holder} className={className ?? 'h-full w-full'} />
}
