import { NextResponse } from 'next/server';

export async function GET() {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;

    if (!apiKey) {
        return NextResponse.json({ error: 'AssemblyAI API key not configured' }, { status: 500 });
    }

    const expiresInSeconds = 60; // 1 minute expiration
    const url = `https://streaming.assemblyai.com/v3/token?expires_in_seconds=${expiresInSeconds}`;

    try {
        const response = await fetch(url, {
            headers: {
                Authorization: apiKey,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return NextResponse.json({ token: data.token });
    } catch (error) {
        console.error('Error generating AssemblyAI token:', error);
        return NextResponse.json({ error: 'Failed to generate token' }, { status: 500 });
    }
}
